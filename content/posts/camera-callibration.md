+++ 
draft = false
date = 2025-01-18T22:13:31+05:30
title = "Camera Callibration"
description = "An introduction to the technique of camera callibration using Zhang's Algorithm"
slug = ""
authors = ["Zuhaib Ul Zamann"]
tags = ["Zhang's Algorithm"]
categories = ["Computer Vision", "Camera Callibration"]
externalLink = ""
series = []
[params]
    katex = true
+++
## Introduction
In this blog, we will know about a basic pinhole camera. We will know what camera matrix is, what are intrinsic and extrinsic parameters. We will also learn how we can find these parameters and will also provide an implementation in python for the same.

So let us start

## Pinhole Camera
In a pinhole camera light enters through a small aperture (known as pinhole) and is projected inside of the light proof box forming an inverted image on the image plane.

It can be mathematically modeled as shown below
![Pinhole Camera](/images/pinhole_camera.jpg)

Assuming the world coordinate frame be centered(origin) at the camera center and the image plane(or the focal plane) being $Z = f$ a point $(X, Y, Z)$ is mapped to a point $(x, y, f)$ such that the line joining $(X, Y, Z)$ and $(x, y, f)$ passes through the camera center (in this case,  origin).
Since $(0, 0,0), (X, Y, Z), (x, y, f)$ all lie on the same line, we have $(x, y, f) = \lambda (X, Y, Z) + (0, 0, 0)$

Simplifying, we get

$$x = \lambda X, y = \lambda Y, f = \lambda Z$$

$$\Rightarrow \lambda = \frac{f}{Z}$$

Hence, we have $x = \frac{X}{Z}f, y = \frac{Y}{Z}f$

In the above expression, we assumed that the origin of the image plane coordinate system lies at P(Principal point), which may not be true in general(Often in image coordinates, we consider the top left corner of the image as being the origin).

Hence if the coordinates of principal point are $(p_x, p_y)$, then the equations are given by $x = \frac{X}{Z}f + p_x, y = \frac{Y}{Z}f + p_y$

## Homogeneous Coordinate system
Consider two points $(X_1, Y_1, Z_1)$ and $(X_2, Y_2, Z_2)$ in $3D$ coordinate system. Suppose we identify the points $(X_1, Y_1, Z_1)$ and $(X_2, Y_2, Z_2)$ being equal if $\frac{X_1}{Z_1} = \frac{X_2}{Z_2}$ and $\frac{Y_1}{Z_1} = \frac{Y_2}{Z_2}$. Such a coordinate system is known  as $3D$ homogeneous coordinate system. 

In homogeneous coordinate system two point $A$ and $B$ are equal if there exists a scalar $k$ such that $kA = B$ in real coordinate system.

We will use homogeneous coordinate system in the rest of the calculations from now on.

### Homogeneous Image Coordinate system
We convert our $2D$ image coordinate system to $3D$ homogeneous coordinate system by mapping point $(x, y)$ to $(x, y, 1)$. Furthermore, we write any coordinate as a column matrix. Hence the point $(x, y)$ in image coordinates will be written as



$$\begin{bmatrix}x\\\\y\\\\1\end{bmatrix}$$

### Homogeneous World Coordinate system
Similar to that Image coordinate system, we will convert our world coordinate system to a homogeneous coordinate system by mapping point $(X, Y, Z)$ in 3D world coordinates to $(X, Y, Z, 1)$ in 4D homogeneous coordinates. 

It is easy to observe that we can move from one coordinate system to other coordinate system very easily e.g. a point $(6, 8, 4, 2)$ in homogeneous world coordinate system represents the point $(\frac{6}{2}, \frac{8}{2}, \frac{4}{2}) =  (3, 4, 2)$ in world coordinate system.

By using, homogeneous coordinate system, the mathematics of camera projection becomes linear.

## Mathematics of camera projection
As we saw above, a point $X, Y, Z$ in world coordinate system is mapped to the point $x = \frac{X}{Z}f + p_x, y = \frac{Y}{Z}f + p_y$ in image coordinate system.

If we take the homogeneous versions of both the systems, then we can say that the point $(X, Y, Z, 1)$ is mapped to the point $(fX +Zp_x. fY + Zp_y , Z)$.

This mapping can be written as

$$\begin{bmatrix}x \\\\ y \\\\ z \end{bmatrix} = \begin{bmatrix}f & 0 & p_x & 0 \\\\ 0 & f&p_y &0 \\\\ 0&0&1&0\end{bmatrix}\begin{bmatrix}X\\\\ Y\\\\ Z\\\\ 1\end{bmatrix}$$

Writing $$K = \begin{bmatrix}f & 0 & p_x\\\\ 0 & f & p_y \\\\ 0 & 0 & 1\end{bmatrix}$$

$$\textbf{X}_{\text{cam}} = \begin{bmatrix}X \\\\ Y \\\\ Z \\\\ 1\end{bmatrix}$$


$$\textbf{x} = \begin{bmatrix}x \\\\ y\\\\z \end{bmatrix}$$

then the above expression takes the form

$$\textbf{x} = K[I\vert 0]X_{\text{cam}}$$

Now in all of the above expressions, we have assumed that the world coordinate system is the camera coordinate system, which may not be true. However we can map any world coordinate system to the camera coordinate system by the simple expression $\textbf{X}_{\text{cam}} = R(\textbf{X} - \textbf{C})|$ where $R$ is a $3\times 3$ rotation matrix and $C$ are the world coordinates of the camera center.

This equation in homogeneous coordinates can be written as 

$$\textbf{X}_{\text{cam}} = \begin{bmatrix}R & -RC\\\\ 0 & 1\end{bmatrix}\textbf{X}$$

Hence in any general setup, the mapping between the world coordinates and the image coordinates by a pinhole camera reads as

$$x = KR[I\vert -C]X$$

## Homography

## Direct Linear Transform(DLT)
Before describing Zhang's algorithm, we need to understand DLT which lies at the core of Zhang's algorithm.<br>
Consider a set of linear equations in a homogenous coordinate system 

## Zhang's Algorithm
